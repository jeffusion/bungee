import Card from "./card.svelte";
import Header from "./card-header.svelte";
import Footer from "./card-footer.svelte";
import Title from "./card-title.svelte";
import Description from "./card-description.svelte";
import Content from "./card-content.svelte";

export {
	Card as Root,
	Header,
	Title,
	Description,
	Content,
	Footer,
	//
	Card,
	Header as CardHeader,
	Title as CardTitle,
	Description as CardDescription,
	Content as CardContent,
	Footer as CardFooter,
};

export type HeadingLevel = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
